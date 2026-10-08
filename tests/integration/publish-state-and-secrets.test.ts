import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => h.db,
}));

const GH_TOKEN = 'ghp_SECRET_IN_DB';
const VERCEL_PAT = 'vcp_SECRET_IN_DB';

function setup(extra: Record<string, any> = {}) {
  const db = createFakeDb({
    forgestudio_projects: [
      {
        id: 'p1', user_id: 'u1', code: 'x',
        github_owner: 'gt340', github_repo: 'blako', github_repo_url: 'https://github.com/gt340/blako',
        github_default_branch: 'main', github_last_commit_sha: 'c905b3a', github_synced_at: '2026-10-07T00:55:38Z',
        vercel_project_id: 'prj_1', vercel_project_name: 'blako', vercel_deployment_id: 'dpl_1',
        vercel_deployment_url: 'https://blako-abc.vercel.app', vercel_production_url: 'https://blako.vercel.app',
        vercel_last_status: 'READY', vercel_deployed_at: '2026-10-07T01:00:00Z',
        ...extra,
      },
    ],
    integrations: [
      { id: 'i1', provider: 'GitHub', user_id: 'u1', access_token: GH_TOKEN, status: 'connected', github_login: 'gt340' },
      { id: 'i2', provider: 'Vercel', user_id: 'u1', access_token: VERCEL_PAT, status: 'connected', vercel_user_id: 'v1' },
    ],
  });
  h.user = { id: 'u1' };
  h.db = db;
  // publish-state is a pure database read: any outbound HTTP call is a bug
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected network call');
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { db, fetchSpy };
}

const getState = async (query: string) => {
  const { GET } = await import('@/app/api/projects/publish-state/route');
  const res = await GET(new Request(`http://localhost/api/projects/publish-state${query}`));
  const text = await res.text();
  return { res, text, data: JSON.parse(text) };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/projects/publish-state', () => {
  it('rejects anonymous callers (401), missing ids (400) and other users (404)', async () => {
    setup();
    h.user = null;
    expect((await getState('?projectId=p1')).res.status).toBe(401);
    h.user = { id: 'u1' };
    expect((await getState('')).res.status).toBe(400);
    h.user = { id: 'u2' };
    expect((await getState('?projectId=p1')).res.status).toBe(404);
    h.user = { id: 'u1' };
    expect((await getState('?projectId=does-not-exist')).res.status).toBe(404);
  });

  it('rebuilds the full publish state (repo, branch, SHA, Vercel project, deployment status) from the database', async () => {
    setup();
    const { res, data } = await getState('?projectId=p1');
    expect(res.status).toBe(200);
    expect(data.github).toEqual({
      owner: 'gt340', repo: 'blako', url: 'https://github.com/gt340/blako', defaultBranch: 'main',
      lastCommitSha: 'c905b3a', syncedAt: '2026-10-07T00:55:38Z',
    });
    expect(data.vercel).toEqual({
      projectId: 'prj_1', projectName: 'blako', deploymentId: 'dpl_1', url: 'https://blako-abc.vercel.app',
      productionUrl: 'https://blako.vercel.app', status: 'READY', deployedAt: '2026-10-07T01:00:00Z',
    });
  });

  it('survives remount: repeated reads return identical state and cause no writes and no outbound calls', async () => {
    const { db, fetchSpy } = setup();
    const first = await getState('?projectId=p1');
    const second = await getState('?projectId=p1');
    expect(second.data).toEqual(first.data);
    expect(db.ops.filter((o) => o.op !== 'select').length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a GitHub-only project (no Vercel yet) and a Vercel project that has no deployment yet', async () => {
    setup({ vercel_project_id: null, vercel_project_name: null, vercel_deployment_id: null });
    expect((await getState('?projectId=p1')).data.vercel).toBeNull();

    setup({ vercel_deployment_id: null, vercel_last_status: null, vercel_deployment_url: null });
    expect((await getState('?projectId=p1')).data.vercel).toMatchObject({ projectId: 'prj_1', deploymentId: null, status: 'NONE' });
  });

  it('a failed Vercel deployment does not erase the successful GitHub state', async () => {
    setup({ vercel_last_status: 'ERROR', vercel_production_url: null });
    const { data } = await getState('?projectId=p1');
    expect(data.vercel.status).toBe('ERROR');
    expect(data.github).toMatchObject({ repo: 'blako', lastCommitSha: 'c905b3a' });
  });

  it('never returns integration secrets', async () => {
    setup();
    const { text } = await getState('?projectId=p1');
    expect(text).not.toContain(GH_TOKEN);
    expect(text).not.toContain(VERCEL_PAT);
    expect(text).not.toContain('access_token');
  });
});

describe('GET /api/integrations (secrets)', () => {
  it('never selects or returns the stored access tokens', async () => {
    const { db } = setup();
    const { GET } = await import('@/app/api/integrations/route');
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(GH_TOKEN);
    expect(text).not.toContain(VERCEL_PAT);
    const selected = db.ops.filter((o) => o.table === 'integrations' && o.op === 'select').map((o) => o.cols).join(',');
    expect(selected).not.toContain('access_token');
  });

  it('rejects anonymous callers and scopes deletes to the caller', async () => {
    const { db } = setup();
    const { GET, DELETE } = await import('@/app/api/integrations/route');
    h.user = null;
    expect((await GET()).status).toBe(401);
    expect((await DELETE(new Request('http://localhost/api/integrations', { method: 'DELETE', body: JSON.stringify({ id: 'i1' }) }))).status).toBe(401);

    h.user = { id: 'u2' }; // another user tries to delete u1's integration
    await DELETE(new Request('http://localhost/api/integrations', { method: 'DELETE', body: JSON.stringify({ id: 'i1' }) }));
    expect(db.tables.integrations.some((r) => r.id === 'i1')).toBe(true); // still there
  });
});

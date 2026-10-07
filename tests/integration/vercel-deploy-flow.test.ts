import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type Row } from '../helpers/fake-db';
import { createFakeVercel, type FakeVercelOptions } from '../helpers/fake-vercel';

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => h.db,
}));

const PAT = 'vcp_SUPER_SECRET_PAT_789';
const OTHER_PAT = 'vcp_OTHER_USERS_PAT_000';
const GH_LINK = {
  github_owner: 'gt340',
  github_repo: 'blako',
  github_repo_id: 1001,
  github_default_branch: 'main',
  github_last_commit_sha: 'abc123',
};

function setup(o: { project?: Row; vercel?: Partial<FakeVercelOptions>; failUpdate?: (t: string, p: Row) => boolean } = {}) {
  const db = createFakeDb(
    {
      forgestudio_projects: [
        {
          id: 'p1', user_id: 'u1', ...GH_LINK,
          vercel_project_id: null, vercel_project_name: null, vercel_deployment_id: null,
          vercel_deployment_url: null, vercel_production_url: null, vercel_last_status: null, vercel_deployed_at: null,
          ...o.project,
        },
      ],
      integrations: [
        { provider: 'Vercel', user_id: 'u1', access_token: PAT },
        { provider: 'Vercel', user_id: 'u2', access_token: OTHER_PAT },
      ],
    },
    { failUpdate: o.failUpdate }
  );
  const vercel = createFakeVercel(o.vercel);
  h.user = { id: 'u1' };
  h.db = db;
  vi.stubGlobal('fetch', vi.fn(vercel.handler));
  const project = () => db.tables.forgestudio_projects.find((r) => r.id === 'p1')!;
  return { db, vercel, project };
}

async function deploy(body: unknown) {
  const { POST } = await import('@/app/api/deploy/vercel/route');
  const pending = POST(new Request('http://localhost/api/deploy/vercel', { method: 'POST', body: JSON.stringify(body) }));
  await vi.runAllTimersAsync(); // lets the route's 2.5s status-poll waits elapse instantly
  const res = await pending;
  const text = await res.text();
  return { res, text, data: JSON.parse(text) };
}

async function status(query: string) {
  const { GET } = await import('@/app/api/deploy/vercel/status/route');
  const res = await GET(new Request(`http://localhost/api/deploy/vercel/status${query}`));
  const text = await res.text();
  return { res, text, data: JSON.parse(text) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/deploy/vercel — access control and validation', () => {
  it('rejects anonymous callers with 401 and calls nothing', async () => {
    const { vercel } = setup();
    h.user = null;
    expect((await deploy({ projectId: 'p1' })).res.status).toBe(401);
    expect(vercel.log.length).toBe(0);
  });

  it("returns 404 for another user's project (browser cannot force someone else's deploy)", async () => {
    const { vercel } = setup();
    h.user = { id: 'u2' };
    expect((await deploy({ projectId: 'p1' })).res.status).toBe(404);
    expect(vercel.log.length).toBe(0);
  });

  it('rejects missing or non-string project ids', async () => {
    setup();
    expect((await deploy({})).res.status).toBe(400);
    expect((await deploy({ projectId: 42 })).res.status).toBe(400);
  });

  it('refuses to deploy a project that has no GitHub link and makes no Vercel call', async () => {
    const { vercel } = setup({ project: { github_owner: null, github_repo: null, github_repo_id: null } });
    const { res } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(400);
    expect(vercel.log.length).toBe(0);
  });
});

describe('POST /api/deploy/vercel — deployment lifecycle', () => {
  it('creates the Vercel project once, saves the link BEFORE deploying, and reaches READY with the stable production URL', async () => {
    const { vercel, db, project } = setup();
    const { res, text, data } = await deploy({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(vercel.calls('POST', '/v11/projects').length).toBe(1);
    expect(data).toMatchObject({ status: 'READY', polled: true, aliasPending: false, productionUrl: 'https://blako.vercel.app', projectName: 'blako' });
    expect(project()).toMatchObject({
      vercel_project_id: data.projectId,
      vercel_deployment_id: data.deploymentId,
      vercel_last_status: 'READY',
      vercel_production_url: 'https://blako.vercel.app',
    });

    const linkSave = db.ops.find((o) => o.op === 'update' && o.payload && 'vercel_project_id' in o.payload && !('vercel_deployment_id' in o.payload))!;
    expect(linkSave.seq).toBeLessThan(vercel.calls('POST', '/v13/deployments')[0].seq);

    expect(text).not.toContain(PAT);
    expect(text).not.toContain(OTHER_PAT);
  });

  it('pins the deployment to the commit ForgeStudio last synced, as a production deployment', async () => {
    const { vercel } = setup();
    await deploy({ projectId: 'p1' });
    const body = vercel.calls('POST', '/v13/deployments')[0].body;
    expect(body.target).toBe('production');
    expect(body.gitSource).toMatchObject({ type: 'github', ref: 'main', repoId: 1001, sha: 'abc123' });
  });

  it('reports a failed build as ERROR with a message — never as success', async () => {
    const { project } = setup({ vercel: { states: ['QUEUED', 'ERROR'] } });
    const { res, data } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ status: 'ERROR', productionUrl: null });
    expect(data.errorMessage).toMatch(/Build failed/);
    expect(project().vercel_last_status).toBe('ERROR');
    expect(project().vercel_production_url).toBeNull();
  });

  it('reports a canceled deployment as CANCELED', async () => {
    const { project } = setup({ vercel: { states: ['QUEUED', 'CANCELED'] } });
    const { data } = await deploy({ projectId: 'p1' });
    expect(data.status).toBe('CANCELED');
    expect(data.productionUrl).toBeNull();
    expect(project().vercel_last_status).toBe('CANCELED');
  });

  it('a build that is still running when server polling ends is returned as in-progress (polled:false), not as success', async () => {
    const { project } = setup({ vercel: { states: ['QUEUED', 'BUILDING'] } });
    const { data } = await deploy({ projectId: 'p1' });
    expect(data.polled).toBe(false);
    expect(['QUEUED', 'BUILDING']).toContain(data.status);
    expect(data.productionUrl).toBeNull();
    expect(project().vercel_deployment_id).toBe(data.deploymentId); // the client can keep polling the status route
  });

  it('READY without a production alias yet is flagged aliasPending and does NOT save a production URL', async () => {
    const { project } = setup({ vercel: { noAlias: true } });
    const { data } = await deploy({ projectId: 'p1' });
    expect(data).toMatchObject({ status: 'READY', aliasPending: true, productionUrl: null });
    expect(project().vercel_production_url).toBeNull();
  });
});

describe('POST /api/deploy/vercel — reuse and duplicate prevention', () => {
  it('reuses an existing Vercel project instead of creating another', async () => {
    const { vercel } = setup({ project: { vercel_project_id: 'prj_1', vercel_project_name: 'blako' } });
    vercel.seedProject('blako', { org: 'gt340', repo: 'blako' });
    const { res } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(vercel.calls('POST', '/v11/projects').length).toBe(0);
    expect(vercel.projects.size).toBe(1);
    expect(vercel.calls('POST', '/v13/deployments').length).toBe(1);
  });

  it('returns the already-running deployment (reused:true) instead of starting a duplicate', async () => {
    const { vercel } = setup({
      project: {
        vercel_project_id: 'prj_1', vercel_project_name: 'blako', vercel_deployment_id: 'dpl_9',
        vercel_last_status: 'BUILDING', vercel_deployed_at: new Date().toISOString(),
      },
    });
    vercel.seedProject('blako', { org: 'gt340', repo: 'blako' });
    vercel.seedDeployment('dpl_9', 'blako', ['BUILDING', 'BUILDING']);

    const { res, data } = await deploy({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ reused: true, deploymentId: 'dpl_9', status: 'BUILDING' });
    expect(vercel.calls('POST', '/v13/deployments').length).toBe(0);
  });

  it('does NOT reuse a deployment that was started long ago (stale) — a retry starts a new one', async () => {
    const { vercel } = setup({
      project: {
        vercel_project_id: 'prj_1', vercel_project_name: 'blako', vercel_deployment_id: 'dpl_9',
        vercel_last_status: 'BUILDING', vercel_deployed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    });
    vercel.seedProject('blako', { org: 'gt340', repo: 'blako' });
    vercel.seedDeployment('dpl_9', 'blako', ['BUILDING']);

    const { data } = await deploy({ projectId: 'p1' });

    expect(data.reused).toBeUndefined();
    expect(vercel.calls('POST', '/v13/deployments').length).toBe(1);
  });

  it('adopts a leftover Vercel project for the SAME repo instead of creating a duplicate', async () => {
    const { vercel, project } = setup();
    const leftover = vercel.seedProject('blako', { org: 'gt340', repo: 'blako' });
    const { res, data } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(vercel.projects.size).toBe(1);
    expect(data.projectId).toBe(leftover.id);
    expect(project().vercel_project_id).toBe(leftover.id);
  });

  it('does not adopt an unrelated project that merely has the same name — uses a unique suffix instead', async () => {
    const { vercel, project } = setup();
    vercel.seedProject('blako', { org: 'someone-else', repo: 'unrelated' });
    const { res } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(vercel.projects.size).toBe(2);
    expect(project().vercel_project_name).toMatch(/^blako-[a-z0-9]+$/);
  });

  it('SIMULATED concurrency (interleaved on one event loop): a double-click creates only one Vercel project', async () => {
    const { vercel } = setup();
    const { POST } = await import('@/app/api/deploy/vercel/route');
    const mk = () => POST(new Request('http://localhost/api/deploy/vercel', { method: 'POST', body: JSON.stringify({ projectId: 'p1' }) }));

    const both = Promise.all([mk(), mk()]);
    await vi.runAllTimersAsync();
    const [a, b] = await both;

    expect(vercel.projects.size).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await a.json()).projectId).toBe((await b.json()).projectId);
  });
});

describe('POST /api/deploy/vercel — failure handling', () => {
  it('PHASE 6A BUG: if saving the Vercel link fails, no deployment is started and the error is reported; a retry adopts the project', async () => {
    let failLink = true;
    const { vercel, project } = setup({ failUpdate: (_t, p) => failLink && 'vercel_project_id' in p });

    const first = await deploy({ projectId: 'p1' });
    expect(first.res.status).toBe(500);
    expect(first.data.error).toMatch(/could not save the link/i);
    expect(vercel.calls('POST', '/v13/deployments').length).toBe(0);

    failLink = false;
    const retry = await deploy({ projectId: 'p1' });
    expect(retry.res.status).toBe(200);
    expect(vercel.projects.size).toBe(1); // the project from attempt 1 was adopted, not duplicated
    expect(project().vercel_project_id).toBe(retry.data.projectId);
  });

  it('PHASE 6A BUG: if only the final deployment-details save fails, the API says persisted:false with a warning', async () => {
    const { project } = setup({ failUpdate: (_t, p) => 'vercel_deployment_id' in p });
    const { res, data } = await deploy({ projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(data.persisted).toBe(false);
    expect(typeof data.warning).toBe('string');
    expect(project().vercel_deployment_id).toBeNull();
    expect(project().vercel_project_id).toBeTruthy(); // the link itself was saved
  });

  it('a Vercel deployment failure returns a safe 502, keeps the project link, and logs no secrets', async () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')].map((s) => s.mockImplementation(() => {}));
    const { project } = setup({ vercel: { createDeploymentFails: true } });

    const { res, text } = await deploy({ projectId: 'p1' });

    expect(res.status).toBe(502);
    expect(text).not.toContain(PAT);
    expect(project().vercel_project_id).toBeTruthy();
    const logged = spies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(PAT);
  });
});

describe('GET /api/deploy/vercel/status', () => {
  const withDeployment = (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup({ ...o, project: { vercel_project_id: 'prj_1', vercel_project_name: 'blako', vercel_deployment_id: 'dpl_9', ...o.project } });
    s.vercel.seedDeployment('dpl_9', 'blako', s.vercel.opts.states);
    return s;
  };

  it('rejects anonymous callers, missing ids, other users, and projects with no deployment', async () => {
    const { vercel } = withDeployment();
    h.user = null;
    expect((await status('?projectId=p1')).res.status).toBe(401);
    h.user = { id: 'u1' };
    expect((await status('')).res.status).toBe(400);
    h.user = { id: 'u2' };
    expect((await status('?projectId=p1')).res.status).toBe(404);
    expect(vercel.log.length).toBe(0); // no Vercel call for any rejected request

    setup(); // project with no deployment yet
    expect((await status('?projectId=p1')).res.status).toBe(404);
  });

  it('progresses QUEUED → BUILDING → READY and only READY yields the verified production URL', async () => {
    const { project } = withDeployment();
    const q = (await status('?projectId=p1')).data;
    const b = (await status('?projectId=p1')).data;
    const r = (await status('?projectId=p1')).data;

    expect([q.status, q.phase, q.productionUrl]).toEqual(['QUEUED', 'preparing', null]);
    expect([b.status, b.phase, b.productionUrl]).toEqual(['BUILDING', 'deploying', null]);
    expect(r).toMatchObject({ status: 'READY', phase: 'ready', productionUrl: 'https://blako.vercel.app', aliasPending: false });
    expect(r.liveCheck).toEqual({ ok: true, status: 200 });
    expect(project().vercel_last_status).toBe('READY');
    expect(project().vercel_production_url).toBe('https://blako.vercel.app');
  });

  it('reports ERROR and CANCELED truthfully', async () => {
    withDeployment({ vercel: { states: ['ERROR'] } });
    const e = (await status('?projectId=p1')).data;
    expect(e).toMatchObject({ status: 'ERROR', phase: 'failed', productionUrl: null });
    expect(e.errorMessage).toBeTruthy();

    withDeployment({ vercel: { states: ['CANCELED'] } });
    expect((await status('?projectId=p1')).data).toMatchObject({ status: 'CANCELED', phase: 'canceled' });
  });

  it('READY without an alias is aliasPending and saves no production URL', async () => {
    const { project } = withDeployment({ vercel: { states: ['READY'], noAlias: true } });
    const { data } = await status('?projectId=p1');
    expect(data).toMatchObject({ status: 'READY', aliasPending: true, productionUrl: null, liveCheck: null });
    expect(project().vercel_production_url).toBeNull();
  });

  it('does not claim the live URL works when it answers 401', async () => {
    withDeployment({ vercel: { states: ['READY'], liveStatus: 401 } });
    const { data } = await status('?projectId=p1');
    expect(data.status).toBe('READY');
    expect(data.liveCheck).toEqual({ ok: false, status: 401 });
  });

  it('resolves the deployment from the database — a client-supplied deploymentId is ignored (no proxy behaviour)', async () => {
    const { vercel } = withDeployment();
    const { res, text } = await status('?projectId=p1&deploymentId=dpl_attacker&url=https://evil.example');
    expect(res.status).toBe(200);
    const deploymentReads = vercel.log.filter((l) => l.path.startsWith('/v13/deployments/')).map((l) => l.path);
    expect(deploymentReads).toEqual(['/v13/deployments/dpl_9']);
    expect(vercel.log.every((l) => l.host === 'api.vercel.com' || l.host === 'blako.vercel.app')).toBe(true);
    expect(text).not.toContain(PAT);
  });
});

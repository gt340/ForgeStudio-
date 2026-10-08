import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type Row } from '../helpers/fake-db';
import { createFakeGithub, json } from '../helpers/fake-github';

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => h.db,
}));

const TOKEN = 'ghp_SUPER_SECRET_TOKEN_123';
const OTHER_TOKEN = 'ghp_OTHER_USERS_TOKEN_456';
const CODE_A = "import { useState } from 'react';\nexport default function Page() { return <h1>Hello A</h1>; }";
const CODE_B = CODE_A.replace('Hello A', 'Hello B');
const OLD = '2020-01-01T00:00:00.000Z';

function setup(o: { project?: Row; others?: Row[]; failUpdate?: (t: string, p: Row) => boolean; failOn?: (m: string, p: string) => Response | null } = {}) {
  const db = createFakeDb(
    {
      forgestudio_projects: [
        {
          id: 'p1', user_id: 'u1', code: CODE_A,
          github_owner: null, github_repo: null, github_repo_id: null, github_default_branch: null,
          github_repo_url: null, github_last_commit_sha: null,
          ...o.project,
        },
        ...(o.others ?? []),
      ],
      integrations: [
        { provider: 'GitHub', user_id: 'u1', access_token: TOKEN },
        { provider: 'GitHub', user_id: 'u2', access_token: OTHER_TOKEN },
      ],
    },
    { failUpdate: o.failUpdate }
  );
  const gh = createFakeGithub({ failOn: o.failOn });
  h.user = { id: 'u1' };
  h.db = db;
  vi.stubGlobal('fetch', vi.fn(gh.handler));
  const project = () => db.tables.forgestudio_projects.find((r) => r.id === 'p1')!;
  return { db, gh, project };
}

const post = (body: unknown) =>
  new Request('http://localhost/api/deploy/github', { method: 'POST', body: JSON.stringify(body) });

async function call(body: unknown) {
  const { POST } = await import('@/app/api/deploy/github/route');
  const res = await POST(post(body));
  const text = await res.text();
  return { res, text, data: JSON.parse(text) };
}

beforeEach(() => {
  delete process.env.PEXELS_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/deploy/github — access control', () => {
  it('rejects anonymous callers with 401 and touches nothing', async () => {
    const { gh } = setup();
    h.user = null;
    const { res } = await call({ projectId: 'p1', repoName: 'blako' });
    expect(res.status).toBe(401);
    expect(gh.log.length).toBe(0);
  });

  it("returns 404 for another user's project and never calls GitHub", async () => {
    const { gh } = setup();
    h.user = { id: 'u2' };
    const { res } = await call({ projectId: 'p1', repoName: 'blako' });
    expect(res.status).toBe(404);
    expect(gh.log.length).toBe(0);
  });

  it.each(['', 'a b', '../x', 'a/b', 'x'.repeat(101), '..'])('rejects malformed repo name %j without creating a repo', async (name) => {
    const { gh } = setup();
    const { res } = await call({ projectId: 'p1', repoName: name });
    expect(res.status).toBe(400);
    expect(gh.calls('POST', '/user/repos').length).toBe(0);
  });

  it('rejects a missing or non-string projectId', async () => {
    setup();
    expect((await call({})).res.status).toBe(400);
    expect((await call({ projectId: { $ne: null } })).res.status).toBe(400);
  });
});

describe('POST /api/deploy/github — sync workflow', () => {
  it('first sync: creates the repo, saves the link BEFORE committing, makes one logical commit, leaks no token', async () => {
    const { gh, db, project } = setup();
    const { res, text, data } = await call({ projectId: 'p1', repoName: 'blako' });

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ owner: 'gt340', repo: 'blako', isNewRepo: true, changed: true, persisted: true });
    expect(gh.messages('blako')).toEqual(['Initial commit', 'ForgeStudio: initial site']);
    expect(project()).toMatchObject({ github_owner: 'gt340', github_repo: 'blako', github_last_commit_sha: data.lastCommitSha });
    expect(typeof project().github_repo_id).toBe('number');

    // what was pushed is the deployable page (use-client directive added)
    expect(gh.headFiles('blako')['app/page.js'].startsWith("'use client';")).toBe(true);

    // ordering: the link was saved before the first tree/commit was written to GitHub
    const linkSave = db.ops.find((o) => o.op === 'update' && o.payload && 'github_repo' in o.payload)!;
    const firstTree = gh.calls('POST', '/git/trees')[0];
    expect(linkSave.seq).toBeLessThan(firstTree.seq);

    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(OTHER_TOKEN);
  });

  it('re-sync with unchanged content makes NO new commit and reuses the existing repo', async () => {
    const { gh } = setup();
    await call({ projectId: 'p1', repoName: 'blako' });
    const before = gh.messages('blako').length;

    const { res, data } = await call({ projectId: 'p1' });

    expect(res.status).toBe(200);
    expect(data.changed).toBe(false);
    expect(gh.messages('blako').length).toBe(before);
    expect(gh.calls('POST', '/user/repos').length).toBe(1); // created exactly once, ever
  });

  it('changed content makes exactly one new sync commit', async () => {
    const { gh, project } = setup();
    await call({ projectId: 'p1', repoName: 'blako' });
    project().code = CODE_B;

    const { data } = await call({ projectId: 'p1' });

    expect(data.changed).toBe(true);
    expect(gh.messages('blako')).toEqual(['Initial commit', 'ForgeStudio: initial site', 'ForgeStudio: update website']);
    expect(gh.headFiles('blako')['app/page.js']).toContain('Hello B');
  });

  it('adopts the existing ForgeStudio repo when the saved link was lost — no second repo, no extra commit', async () => {
    const { gh, project } = setup();
    await call({ projectId: 'p1', repoName: 'blako' });
    Object.assign(project(), { github_owner: null, github_repo: null, github_repo_id: null, github_repo_url: null, github_last_commit_sha: null });

    const { res, data } = await call({ projectId: 'p1', repoName: 'blako' });

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ adopted: true, changed: false, isNewRepo: false });
    expect(gh.repos.size).toBe(1);
    expect(gh.messages('blako').length).toBe(2);
    expect(project().github_repo).toBe('blako'); // link restored
  });

  it('rejects a repo that already belongs to another ForgeStudio project', async () => {
    const s = setup({
      others: [{ id: 'p2', user_id: 'u1', code: CODE_A, github_repo: 'blako', github_owner: 'gt340', github_repo_id: null }],
    });
    const repo = s.gh.seedRepo('blako', { message: 'ForgeStudio: initial site' });
    s.db.tables.forgestudio_projects.find((r) => r.id === 'p2')!.github_repo_id = repo.id;

    const { res, data } = await call({ projectId: 'p1', repoName: 'blako' });

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already linked to another ForgeStudio project/);
    expect(s.gh.messages('blako')).toEqual(['ForgeStudio: initial site']); // untouched
  });

  it('refuses to adopt a repository that ForgeStudio did not create', async () => {
    const { gh } = setup();
    gh.seedRepo('mine', { message: 'my own work', createdAt: OLD });

    const { res } = await call({ projectId: 'p1', repoName: 'mine' });

    expect(res.status).toBe(409);
    expect(gh.messages('mine')).toEqual(['my own work']); // untouched
  });
});

describe('POST /api/deploy/github — failure handling', () => {
  it('a GitHub API failure returns a safe 502, then an existing link keeps working on the next attempt', async () => {
    let failTrees = true;
    const { gh, project } = setup({
      failOn: (m, p) => (failTrees && m === 'POST' && p.endsWith('/git/trees') ? json(500, { message: 'Server Error' }) : null),
    });

    const failed = await call({ projectId: 'p1', repoName: 'blako' });
    expect(failed.res.status).toBe(502);
    expect(failed.text).not.toContain(TOKEN);
    expect(project().github_repo).toBe('blako'); // the link saved before the failure survives

    failTrees = false;
    const retry = await call({ projectId: 'p1' }); // no repoName needed any more
    expect(retry.res.status).toBe(200);
    expect(retry.data.changed).toBe(true);
    expect(gh.repos.size).toBe(1); // still one repository
    // exactly one ForgeStudio commit was made (the retry labels it "update" because the repo already existed)
    expect(gh.messages('blako')).toEqual(['Initial commit', 'ForgeStudio: update website']);
  });

  it('PHASE 6A BUG: if saving the project link fails, the API reports failure — never success — and pushes no site', async () => {
    const { gh } = setup({ failUpdate: (table) => table === 'forgestudio_projects' });

    const { res, data } = await call({ projectId: 'p1', repoName: 'blako' });

    expect(res.status).toBe(500);
    expect(data.error).toMatch(/could not save the link/i);
    expect(data.lastCommitSha).toBeUndefined();
    expect(data.persisted).toBeUndefined();
    expect(gh.messages('blako')).toEqual(['Initial commit']); // no ForgeStudio commit was made
  });

  it('PHASE 6A BUG: if only the final sync-details save fails, the API says persisted:false with a warning', async () => {
    const { gh, project } = setup({ failUpdate: (_t, p) => 'github_last_commit_sha' in p });
    const repo = gh.seedRepo('blako', { message: 'ForgeStudio: initial site' });
    Object.assign(project(), {
      github_owner: 'gt340', github_repo: 'blako', github_repo_id: repo.id,
      github_default_branch: 'main', github_repo_url: 'https://github.com/gt340/blako',
    });

    const { res, data } = await call({ projectId: 'p1' });

    expect(res.status).toBe(200); // the push itself succeeded
    expect(data.persisted).toBe(false);
    expect(typeof data.warning).toBe('string');
    expect(project().github_last_commit_sha).toBeNull(); // and the DB really was not updated
  });

  it('never writes the access token to the logs, even on failure paths', async () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')].map((s) => s.mockImplementation(() => {}));
    setup({ failOn: (m, p) => (m === 'POST' && p.endsWith('/git/commits') ? json(500, { message: 'Server Error' }) : null) });

    await call({ projectId: 'p1', repoName: 'blako' });

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args)).join('\n');
    expect(logged.length).toBeGreaterThan(0); // the failure was logged...
    expect(logged).not.toContain(TOKEN); // ...without the secret
  });
});

describe('POST /api/deploy/github — repeated actions', () => {
  it('SIMULATED concurrency (interleaved on one event loop): two simultaneous first-syncs create only one repository', async () => {
    const { gh } = setup();

    const [a, b] = await Promise.all([call({ projectId: 'p1', repoName: 'blako' }), call({ projectId: 'p1', repoName: 'blako' })]);

    expect(gh.repos.size).toBe(1);
    expect(gh.calls('POST', '/user/repos').length).toBe(2); // both tried...
    expect([200, 409]).toContain(a.res.status); // ...but the 2nd was adopted or refused, never a duplicate repo
    expect([200, 409]).toContain(b.res.status);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal, thenable chainable Supabase mock. Each `.from(table)` call pops the
// next queued response from `responseQueue`, and every chained method (select,
// insert, update, delete, eq, order, in, single) returns the same chain object,
// which resolves to that queued response when awaited — matching how the real
// supabase-js PostgrestFilterBuilder is itself thenable.
let responseQueue: any[] = [];
const calls: { table: string; method: string; args: any[] }[] = [];

function makeChain(table: string) {
  const response = responseQueue.shift() ?? { data: null, error: null };
  const chain: any = {
    select: (...a: any[]) => { calls.push({ table, method: 'select', args: a }); return chain; },
    insert: (...a: any[]) => { calls.push({ table, method: 'insert', args: a }); return chain; },
    update: (...a: any[]) => { calls.push({ table, method: 'update', args: a }); return chain; },
    delete: (...a: any[]) => { calls.push({ table, method: 'delete', args: a }); return chain; },
    eq: (...a: any[]) => { calls.push({ table, method: 'eq', args: a }); return chain; },
    order: (...a: any[]) => { calls.push({ table, method: 'order', args: a }); return chain; },
    single: () => Promise.resolve(response),
    then: (resolve: any) => resolve(response),
  };
  return chain;
}

const mockGetCurrentUser = vi.fn();
const mockSupabase = { from: (table: string) => makeChain(table) };

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  createSupabaseServerClient: vi.fn(() => Promise.resolve(mockSupabase)),
}));

const OWNER_ID = 'owner-uuid';
const OTHER_ID = 'other-uuid';

function makeRequest(url: string, body: unknown) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

describe('/api/projects/update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseQueue = [];
    calls.length = 0;
  });

  it('returns 404 and performs no write when the project is not owned by the caller', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OTHER_ID });
    responseQueue = [{ data: null, error: { message: 'no rows' } }]; // ownership lookup fails
    const { POST } = await import('@/app/api/projects/update/route');

    const res = await POST(
      makeRequest('http://localhost/api/projects/update', { id: 'someone-elses-project', code: 'x' })
    );

    expect(res.status).toBe(404);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('returns 409 with no write when expectedVersion is stale', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [
      { data: { id: 'p1' }, error: null }, // ownership lookup succeeds
      { count: 6, error: null }, // real latest version is 6, not the 5 the client expects
    ];
    const { POST } = await import('@/app/api/projects/update/route');

    const res = await POST(
      makeRequest('http://localhost/api/projects/update', { id: 'p1', code: 'new code', expectedVersion: 5 })
    );

    expect(res.status).toBe(409);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('succeeds and creates the next version when expectedVersion matches', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [
      { data: { id: 'p1' }, error: null }, // ownership
      { count: 5, error: null }, // current latest version
      { data: null, error: null }, // the update itself
      { data: null, error: null }, // the version insert
    ];
    const { POST } = await import('@/app/api/projects/update/route');

    const res = await POST(
      makeRequest('http://localhost/api/projects/update', { id: 'p1', code: 'new code', expectedVersion: 5 })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.version).toBe(6);
  });
});

describe('/api/projects/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseQueue = [];
    calls.length = 0;
  });

  it('returns 404 and performs no delete when the project is not owned by the caller', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OTHER_ID });
    responseQueue = [{ data: null, error: { message: 'no rows' } }];
    const { POST } = await import('@/app/api/projects/delete/route');

    const res = await POST(makeRequest('http://localhost/api/projects/delete', { id: 'someone-elses-project' }));

    expect(res.status).toBe(404);
    expect(calls.some((c) => c.method === 'delete')).toBe(false);
  });

  it('rejects an anonymous request with 401 before any database access', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const { POST } = await import('@/app/api/projects/delete/route');

    const res = await POST(makeRequest('http://localhost/api/projects/delete', { id: 'p1' }));

    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it('succeeds and scopes the delete to id AND user_id when owned', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [
      { data: { id: 'p1' }, error: null }, // ownership check
      { error: null }, // the delete itself
    ];
    const { POST } = await import('@/app/api/projects/delete/route');

    const res = await POST(makeRequest('http://localhost/api/projects/delete', { id: 'p1' }));

    expect(res.status).toBe(200);
    const deleteCallIndex = calls.findIndex((c) => c.method === 'delete');
    expect(deleteCallIndex).toBeGreaterThan(-1);
    // the delete chain must be scoped by both id and user_id, not id alone
    const eqArgsAfterDelete = calls.slice(deleteCallIndex).filter((c) => c.method === 'eq').map((c) => c.args[0]);
    expect(eqArgsAfterDelete).toContain('user_id');
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

// APPLICATION-LEVEL test of POST /api/projects/delete (mocked database).
// This is NOT a database/RLS test: whether the real `authenticated` role may DELETE, and whether RLS stops
// other users, is verified separately against the real database with supabase/tests/rls_grants_check.sql.
// A mocked database cannot catch a missing GRANT (that is exactly how the original bug slipped through).

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => h.db,
}));

function setup() {
  const db = createFakeDb({
    forgestudio_projects: [
      { id: 'p1', user_id: 'u1' },
      { id: 'p2', user_id: 'u2' },
    ],
  });
  h.user = { id: 'u1' };
  h.db = db;
  return db;
}

const del = async (body: unknown) => {
  const { POST } = await import('@/app/api/projects/delete/route');
  const res = await POST(new Request('http://localhost/api/projects/delete', { method: 'POST', body: JSON.stringify(body) }));
  return { res, data: await res.json() };
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/projects/delete (application level, mocked database)', () => {
  it('rejects anonymous callers and touches nothing', async () => {
    const db = setup();
    h.user = null;
    const { res } = await del({ id: 'p1' });
    expect(res.status).toBe(401);
    expect(db.ops.length).toBe(0);
  });

  it('rejects a missing id', async () => {
    setup();
    expect((await del({})).res.status).toBe(400);
  });

  it('deletes the caller\'s own project, scoped by both id and user_id, and leaves other projects alone', async () => {
    const db = setup();
    const { res, data } = await del({ id: 'p1' });
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(db.tables.forgestudio_projects.map((r) => r.id)).toEqual(['p2']);
    const deleteOp = db.ops.find((o) => o.op === 'delete')!;
    expect(deleteOp.filters).toEqual(expect.arrayContaining([['id', 'eq', 'p1'], ['user_id', 'eq', 'u1']]));
  });

  it('returns 404 and issues no delete when the project belongs to someone else', async () => {
    const db = setup();
    const { res } = await del({ id: 'p2' });
    expect(res.status).toBe(404);
    expect(db.ops.some((o) => o.op === 'delete')).toBe(false);
    expect(db.tables.forgestudio_projects.some((r) => r.id === 'p2')).toBe(true);
  });

  it('reports a database refusal (e.g. permission denied) as a failure, never as success', async () => {
    const q: any = {
      select: () => q,
      delete: () => q,
      eq: () => q,
      single: async () => ({ data: { id: 'p1' }, error: null }),
      then: (resolve: any) => resolve({ error: { code: '42501', message: 'permission denied for table forgestudio_projects' } }),
    };
    h.user = { id: 'u1' };
    h.db = { from: () => q };
    const { res, data } = await del({ id: 'p1' });
    expect(res.status).toBe(500);
    expect(data.success).toBeUndefined();
  });
});

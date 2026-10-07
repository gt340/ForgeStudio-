import { describe, it, expect, vi, beforeEach } from 'vitest';

// Input-limit / abuse checks for /api/generate (Anthropic is mocked: no credits are ever used) and a
// SIMULATED stale-update scenario for /api/projects/update.

const h = vi.hoisted(() => ({ user: null as any, queue: [] as any[], calls: [] as { table: string; method: string }[] }));

function makeChain(table: string) {
  const response = h.queue.shift() ?? { data: null, error: null };
  const rec = (method: string) => (..._a: any[]) => {
    h.calls.push({ table, method });
    return chain;
  };
  const chain: any = {
    select: rec('select'), insert: rec('insert'), update: rec('update'), delete: rec('delete'),
    eq: rec('eq'), order: rec('order'),
    single: () => Promise.resolve(response),
    then: (resolve: any) => resolve(response),
  };
  return chain;
}

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => ({ from: (t: string) => makeChain(t) }),
}));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: (...args: any[]) => mockCreate(...args) };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 'u1' };
  h.queue = [];
  h.calls = [];
});

const gen = async (body: unknown) => {
  const { POST } = await import('@/app/api/generate/route');
  const res = await POST(new Request('http://localhost/api/generate', { method: 'POST', body: JSON.stringify(body) }));
  return { res, text: await res.text() };
};

describe('/api/generate input limits (Phase 2 limits stay enforced; Anthropic never called)', () => {
  it('rejects oversized existingCode', async () => {
    const { res } = await gen({ prompt: 'Add a footer', existingCode: 'x'.repeat(5_000_000) });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an oversized error log', async () => {
    const { res } = await gen({ prompt: 'Fix it', existingCode: 'export default function A(){return null}', errorLog: 'e'.repeat(5_000_000) });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([42, { a: 1 }, ['x'], null])('rejects a non-string prompt %j', async (prompt) => {
    const { res } = await gen({ prompt });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not leak internals when the model call fails unexpectedly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreate.mockRejectedValue(new Error('boom: sk-ant-SECRET stack at /var/task/route.js:1'));
    const { res, text } = await gen({ prompt: 'Build a bakery site' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(text).not.toContain('sk-ant-SECRET');
    expect(text).not.toContain('/var/task');
  });
});

describe('/api/projects/update stale-update protection (SIMULATED sequential requests, not true parallelism)', () => {
  const update = async (body: unknown) => {
    const { POST } = await import('@/app/api/projects/update/route');
    return POST(new Request('http://localhost/api/projects/update', { method: 'POST', body: JSON.stringify(body) }));
  };

  it('Request B (version N) succeeds, then Request A (stale N) gets 409 and writes nothing', async () => {
    // B: ownership ok, current version 5, update ok, version insert ok
    h.queue = [{ data: { id: 'p1' }, error: null }, { count: 5, error: null }, { error: null }, { error: null }];
    const b = await update({ id: 'p1', code: 'B content', expectedVersion: 5 });
    expect(b.status).toBe(200);
    expect((await b.json()).version).toBe(6);

    // A still believes the project is at version 5, but the database now says 6
    h.calls = [];
    h.queue = [{ data: { id: 'p1' }, error: null }, { count: 6, error: null }];
    const a = await update({ id: 'p1', code: 'A content (stale)', expectedVersion: 5 });

    expect(a.status).toBe(409);
    expect(h.calls.some((c) => c.method === 'update' || c.method === 'insert')).toBe(false); // B is not overwritten
  });

  it('rejects anonymous updates', async () => {
    h.user = null;
    const res = await update({ id: 'p1', code: 'x', expectedVersion: 1 });
    expect(res.status).toBe(401);
    expect(h.calls.length).toBe(0);
  });
});

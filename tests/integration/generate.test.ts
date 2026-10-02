import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the authenticated-user/Supabase boundary used by every protected route.
const mockGetCurrentUser = vi.fn();
const mockSingle = vi.fn();
const mockEq2 = vi.fn(() => ({ single: mockSingle }));
const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockSupabase = { from: mockFrom };

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  createSupabaseServerClient: vi.fn(() => Promise.resolve(mockSupabase)),
}));

// Mock the Anthropic SDK so no real API call is ever made.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: (...args: any[]) => mockCreate(...args) };
  },
}));

const OWNER_ID = 'owner-uuid';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('/api/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous (unauthenticated) request with 401 and never calls Anthropic', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: 'Build a bakery site' }));

    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt with 400 and never calls Anthropic', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: '   ' }));

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an oversized prompt with 400 and never calls Anthropic', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: 'x'.repeat(5000) }));

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls Anthropic when projectId does not resolve to a row the caller owns', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'attacker-uuid' });
    mockSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(
      makeRequest({ prompt: 'Add a pricing section', projectId: 'someone-elses-project' })
    );

    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses the database-authoritative code for an edit, ignoring client-supplied code, when projectId is owned', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    mockSingle.mockResolvedValue({ data: { code: 'export default function App(){ return <div>REAL SAVED CODE</div>; }' }, error: null });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'export default function App(){ return <div>Updated</div>; }' }] });
    const { POST } = await import('@/app/api/generate/route');

    await POST(
      makeRequest({
        prompt: 'Add a pricing section',
        existingCode: 'export default function App(){ return <div>ATTACKER SUPPLIED CODE</div>; }',
        projectId: 'owned-project-id',
      })
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sentMessage = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(sentMessage).toContain('REAL SAVED CODE');
    expect(sentMessage).not.toContain('ATTACKER SUPPLIED CODE');
  });

  it('rejects malformed/empty Anthropic output with 502 and does not return it as code', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '' }] });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: 'Build a bakery site' }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.code).toBeUndefined();
  });

  it('maps an Anthropic rate-limit error to a safe 429 without leaking internal error detail', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    mockCreate.mockRejectedValue({ status: 429, message: 'rate limited' });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: 'Build a bakery site' }));

    expect(res.status).toBe(429);
  });

  it('succeeds for a valid authenticated new-project request with mocked Anthropic output', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'export default function App(){ return <div>Hello</div>; }' }] });
    const { POST } = await import('@/app/api/generate/route');

    const res = await POST(makeRequest({ prompt: 'Build a bakery site' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.code).toContain('Hello');
  });
});

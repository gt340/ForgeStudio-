/// <reference types="vite/client" />
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Every API route must refuse an anonymous caller before doing any work. The routes enforce auth
// themselves (middleware only guards /build pages), so a NEW route that forgets the check would
// otherwise ship open. This test discovers every route.ts automatically.
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => null,
  createSupabaseServerClient: async () => {
    throw new Error('an anonymous request reached the database client');
  },
}));

// Routes that are public BY DESIGN (OAuth redirects/callbacks start before a ForgeStudio session exists
// or carry their own state/signature checks). Keep this list short and justify every entry.
const PUBLIC_BY_DESIGN: string[] = ['/app/api/auth/'];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const routes = import.meta.glob('/app/api/**/route.ts');

describe('API routes require a signed-in user (anonymous sweep)', () => {
  it('discovers the API routes', () => {
    expect(Object.keys(routes).length).toBeGreaterThan(10);
  });

  for (const [path, load] of Object.entries(routes)) {
    if (PUBLIC_BY_DESIGN.some((p) => path.startsWith(p))) continue;

    it(`${path.replace('/app/api', '')} answers 401/403 to anonymous callers`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod: any = await load();
      const handlers = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(handlers.length).toBeGreaterThan(0);

      for (const method of handlers) {
        const init: any = method === 'GET' ? { method } : { method, body: '{}' };
        const req = new NextRequest('http://localhost/api/x?projectId=p1&id=p1', init);
        const res: Response = await mod[method](req, { params: Promise.resolve({}) });
        expect({ method, status: res.status }).toEqual({ method, status: expect.stringMatching(/.*/) });
        expect([401, 403]).toContain(res.status);
      }
    });
  }
});

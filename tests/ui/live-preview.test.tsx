// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import LivePreview from '@/components/LivePreview';

// Phase 7B-A/7B-C component tests: Delete workflow and Export button of the builder.
// Every network call is a stub — no database, GitHub, Vercel, Anthropic or ForgeStudio account is involved,
// and no real project is touched.

const PROJECTS = [
  { id: 'p1', created_at: '2026-10-01T00:00:00Z', prompt: 'Alpha bakery site', code: 'export default function A(){return null}', preview_url: null, sandbox_id: null, latest_version: 1,
    github_owner: 'gt340', github_repo: 'alpha', github_repo_url: 'https://github.com/gt340/alpha' },
  { id: 'p2', created_at: '2026-10-02T00:00:00Z', prompt: 'Beta florist site', code: 'export default function B(){return null}', preview_url: null, sandbox_id: null, latest_version: 1 },
];

type Reply = { status: number; body?: any; zip?: boolean } | 'abort' | 'network';
type Routes = Partial<Record<'list' | 'delete' | 'export' | 'sandbox', Reply>>;

function mockApi(routes: Routes) {
  const calls: { url: string; body?: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
      const key = u.includes('/api/projects/list') ? 'list'
        : u.includes('/api/projects/delete') ? 'delete'
        : u.includes('/api/export') ? 'export'
        : u.includes('/api/sandbox/create') ? 'sandbox' : null;
      const r = key ? routes[key] : undefined;
      if (r === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (r === 'network') throw new TypeError('Failed to fetch');
      if (!r) return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
      if (r.zip) return new Response('PK-fake-zip', { status: r.status, headers: { 'content-type': 'application/zip' } });
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    })
  );
  return { calls, count: (needle: string) => calls.filter((c) => c.url.includes(needle)).length };
}

const listOk: Reply = { status: 200, body: { projects: PROJECTS } };

// The prompt textarea shows the open project's prompt too, so look project rows up INSIDE the history panel only.
const panel = () => within(screen.getByText('Your saved projects').parentElement as HTMLElement);

async function openHistory() {
  fireEvent.click(screen.getByText('History'));
  await screen.findByText('Your saved projects');
  await waitFor(() => expect(panel().getByText('Alpha bakery site')).toBeTruthy());
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Delete workflow (UI)', () => {
  it('asks for confirmation, and the dialog says linked GitHub repos and Vercel deployments are NOT deleted', async () => {
    const api = mockApi({ list: listOk, delete: { status: 200, body: { success: true } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LivePreview />);
    await openHistory();

    fireEvent.click(screen.getAllByText('Delete')[0]);

    expect(confirm).toHaveBeenCalledTimes(1);
    const text = String(confirm.mock.calls[0][0]);
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toMatch(/GitHub/);
    expect(text).toMatch(/Vercel/);
    expect(text).toMatch(/NOT deleted/);
    // declined -> nothing is sent
    expect(api.count('/api/projects/delete')).toBe(0);
    expect(panel().getByText('Alpha bakery site')).toBeTruthy();
  });

  it('deletes only the chosen project: sends its id and removes just that row', async () => {
    const api = mockApi({ list: listOk, delete: { status: 200, body: { success: true } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LivePreview />);
    await openHistory();

    fireEvent.click(screen.getAllByText('Delete')[1]); // Beta
    await waitFor(() => expect(panel().queryByText('Beta florist site')).toBeNull());

    expect(panel().getByText('Alpha bakery site')).toBeTruthy();
    const del = api.calls.filter((c) => c.url.includes('/api/projects/delete'));
    expect(del).toHaveLength(1);
    expect(del[0].body).toEqual({ id: 'p2' });
  });

  it('keeps the row and shows the server error when the delete is refused (never a fake success)', async () => {
    mockApi({ list: listOk, delete: { status: 404, body: { error: 'Project not found' } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LivePreview />);
    await openHistory();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    await screen.findByText(/Request failed \(404\)/);
    expect(panel().getByText('Alpha bakery site')).toBeTruthy();
  });

  it('a delete timeout is described as a SERVER timeout, not as the AI being slow', async () => {
    mockApi({ list: listOk, delete: 'abort' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LivePreview />);
    await openHistory();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    const msg = await screen.findByText(/took too long to respond/);
    expect(msg.textContent).toMatch(/The server took too long/);
    expect(msg.textContent).not.toMatch(/AI/);
    expect(panel().getByText('Alpha bakery site')).toBeTruthy();
  });

  it('clears the stale preview/editor state when the OPEN project is deleted (and it can no longer be exported)', async () => {
    const api = mockApi({
      list: listOk,
      sandbox: { status: 200, body: {} }, // no sandboxId -> the opened project lands in the error state with its code loaded
      delete: { status: 200, body: { success: true } },
      export: { status: 200, zip: true },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LivePreview />);
    await openHistory();

    // open project p1 -> its prompt is loaded and the (error) preview area is shown
    fireEvent.click(panel().getByText('Alpha bakery site'));
    await screen.findByText(/Something went wrong/);
    expect((screen.getByPlaceholderText(/Build a landing page/) as HTMLTextAreaElement).value).toBe('Alpha bakery site');

    // delete that same project from History
    await openHistory();
    fireEvent.click(screen.getAllByText('Delete')[0]);
    await waitFor(() => expect(panel().queryByText('Alpha bakery site')).toBeNull());

    // preview/editor state is gone, back to the empty builder
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect((screen.getByPlaceholderText(/Build a landing page/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Let.s build something/)).toBeTruthy();

    // and the deleted project's code can no longer be exported
    fireEvent.click(screen.getByText('Export as ZIP'));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.count('/api/export')).toBe(0);
  });

  it('does NOT reset the open project when a DIFFERENT project is deleted', async () => {
    mockApi({ list: listOk, sandbox: { status: 200, body: {} }, delete: { status: 200, body: { success: true } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LivePreview />);
    await openHistory();

    fireEvent.click(panel().getByText('Alpha bakery site'));
    await screen.findByText(/Something went wrong/);

    await openHistory();
    fireEvent.click(screen.getAllByText('Delete')[1]); // Beta, not the open one
    await waitFor(() => expect(panel().queryByText('Beta florist site')).toBeNull());

    expect(screen.getByText(/Something went wrong/)).toBeTruthy();
    expect((screen.getByPlaceholderText(/Build a landing page/) as HTMLTextAreaElement).value).toBe('Alpha bakery site');
  });
});

describe('Export button (UI)', () => {
  async function openAlpha(routes: Routes) {
    const api = mockApi({ list: listOk, sandbox: { status: 200, body: {} }, ...routes });
    render(<LivePreview />);
    await openHistory();
    fireEvent.click(panel().getByText('Alpha bakery site'));
    await screen.findByText(/Something went wrong/);
    return api;
  }

  function spyDownload() {
    (URL as any).createObjectURL = vi.fn(() => 'blob:fake');
    (URL as any).revokeObjectURL = vi.fn();
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  }

  it('downloads only on a successful application/zip response', async () => {
    const click = spyDownload();
    const api = await openAlpha({ export: { status: 200, zip: true } });
    fireEvent.click(screen.getByText('Export as ZIP'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(api.count('/api/export')).toBe(1);
    expect(api.calls.find((c) => c.url.includes('/api/export'))!.body).toEqual({ code: PROJECTS[0].code });
  });

  for (const [status, error] of [[401, 'Unauthorized'], [400, 'Missing code'], [500, 'Could not build the export. Please try again.']] as const) {
    it(`never downloads an HTTP ${status} error as a ZIP; shows the error instead`, async () => {
      const click = spyDownload();
      await openAlpha({ export: { status, body: { error } } });
      fireEvent.click(screen.getByText('Export as ZIP'));
      await screen.findByText(error);
      expect(click).not.toHaveBeenCalled();
      expect((URL as any).createObjectURL).not.toHaveBeenCalled();
    });
  }

  it('never downloads a 200 response that is not a ZIP', async () => {
    const click = spyDownload();
    await openAlpha({ export: { status: 200, body: { hello: 'not a zip' } } });
    fireEvent.click(screen.getByText('Export as ZIP'));
    await screen.findByText(/Export failed \(200\)/);
    expect(click).not.toHaveBeenCalled();
  });

  it('reports a network failure without downloading anything', async () => {
    const click = spyDownload();
    await openAlpha({ export: 'network' });
    fireEvent.click(screen.getByText('Export as ZIP'));
    await screen.findByText(/Network issue/);
    expect(click).not.toHaveBeenCalled();
  });
});

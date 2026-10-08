// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import PublishPanel, { type GithubInfo, type VercelInfo } from '@/components/PublishPanel';

// Component tests for the Publish panel. Every network call is a stub — no GitHub, Vercel, Anthropic or
// ForgeStudio account is involved, and nothing here can navigate a real browser.

const GITHUB: GithubInfo = {
  owner: 'gt340', repo: 'blako', url: 'https://github.com/gt340/blako', defaultBranch: 'main',
  lastCommitSha: 'c905b3a0000000000000000000000000000000', syncedAt: '2026-10-07T00:55:38Z',
};
const vercel = (status: string, over: Partial<VercelInfo> = {}): VercelInfo => ({
  projectId: 'prj_1', projectName: 'blako', deploymentId: 'dpl_1', url: 'https://blako-abc.vercel.app',
  productionUrl: status === 'READY' ? 'https://blako.vercel.app' : null, status, ...over,
});

type Reply = { status: number; body: any };
type Handlers = Partial<Record<'state' | 'github' | 'deploy' | 'status', Reply | (() => Reply | Promise<Reply>)>>;

function mockApi(handlers: Handlers = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: any) => {
      const method = init?.method || 'GET';
      calls.push(`${method} ${String(url).split('?')[0]}`);
      const key = String(url).includes('/api/projects/publish-state') ? 'state'
        : String(url).includes('/api/deploy/github') ? 'github'
        : String(url).includes('/api/deploy/vercel/status') ? 'status'
        : String(url).includes('/api/deploy/vercel') ? 'deploy' : null;
      const h = key ? handlers[key] : undefined;
      const reply: Reply = h ? await (typeof h === 'function' ? h() : h) : { status: 404, body: {} };
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
    })
  );
  return { calls, count: (needle: string) => calls.filter((c) => c.includes(needle)).length };
}

const openSpy = () => vi.spyOn(window, 'open').mockImplementation(() => null);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const panel = (g: GithubInfo | null, v: VercelInfo | null) => <PublishPanel projectId="p1" initialGithub={g} initialVercel={v} />;
const text = (re: RegExp | string) => screen.queryByText(re);
const count = (re: RegExp | string) => screen.queryAllByText(re).length;
const button = (name: string) => screen.queryByRole('button', { name });

describe('PublishPanel — GitHub step', () => {
  it('before any sync: offers Push to GitHub (disabled until a repo name is typed) and no Vercel step', () => {
    mockApi();
    render(panel(null, null));
    expect((button('Push to GitHub') as HTMLButtonElement).disabled).toBe(true);
    expect(button('Deploy to Vercel')).toBeNull();
  });

  it('after a successful sync stays on the page, shows GitHub ✓ Synced with repo/branch/commit, and offers Deploy to Vercel', async () => {
    const open = openSpy();
    const href = window.location.href;
    const api = mockApi({
      github: { status: 200, body: { owner: 'gt340', repo: 'blako', url: GITHUB.url, defaultBranch: 'main', lastCommitSha: 'c905b3a1111', changed: true, persisted: true, warning: null } },
    });
    render(panel(null, null));

    fireEvent.change(screen.getByPlaceholderText('repo-name'), { target: { value: 'blako' } });
    fireEvent.click(button('Push to GitHub')!);

    await waitFor(() => expect(text(/Synced successfully/)).not.toBeNull());
    expect(text(/gt340\/blako/)).not.toBeNull();
    expect(text(/Branch:/)).not.toBeNull();
    expect(text(/c905b3a/)).not.toBeNull();
    const deploy = button('Deploy to Vercel') as HTMLButtonElement;
    expect(deploy.disabled).toBe(false);

    // no navigation of any kind, and Vercel was not triggered by the GitHub step
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(api.count('/api/deploy/vercel')).toBe(0);
  });

  it('the GitHub repository is only a secondary link that opens in a new tab', () => {
    mockApi();
    render(panel(GITHUB, null));
    const link = screen.getByText('View GitHub repository').closest('a')!;
    expect(link.getAttribute('href')).toBe(GITHUB.url);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('PHASE 6A BUG: when the server could not save the link it does NOT claim a full sync', async () => {
    mockApi({
      github: { status: 200, body: { owner: 'gt340', repo: 'blako', url: GITHUB.url, defaultBranch: 'main', lastCommitSha: 'c905b3a1111', changed: true, persisted: false, warning: 'GitHub was updated, but ForgeStudio could not save the sync details.' } },
    });
    render(panel(null, null));
    fireEvent.change(screen.getByPlaceholderText('repo-name'), { target: { value: 'blako' } });
    fireEvent.click(button('Push to GitHub')!);

    await waitFor(() => expect(count(/not fully saved/i)).toBeGreaterThan(0));
    expect(text(/Synced successfully/)).toBeNull();
    expect(text(/could not save the sync details/)).not.toBeNull();
  });

  it('a GitHub failure shows the error, offers Retry GitHub sync, and does not advance to Vercel', async () => {
    mockApi({ github: { status: 502, body: { error: 'Failed to stage files on GitHub (status 500)' } } });
    render(panel(null, null));
    fireEvent.change(screen.getByPlaceholderText('repo-name'), { target: { value: 'blako' } });
    fireEvent.click(button('Push to GitHub')!);

    await waitFor(() => expect(text(/Failed to stage files on GitHub/)).not.toBeNull());
    expect(button('Retry GitHub sync')).not.toBeNull();
    expect(button('Deploy to Vercel')).toBeNull();
  });
});

describe('PublishPanel — state comes from the database (remount / refresh)', () => {
  const state = { status: 200, body: { github: GITHUB, vercel: vercel('READY') } };

  it('rebuilds GitHub + Vercel state after a remount without any POST (no new push, no new project)', async () => {
    const api = mockApi({ state });
    const first = render(panel(null, null));
    await waitFor(() => expect(text(/Synced successfully/)).not.toBeNull());
    expect(text('Open live site')).not.toBeNull();
    expect(button('Redeploy to Vercel')).not.toBeNull();
    first.unmount();

    render(panel(null, null)); // a second mount, as after a browser refresh
    await waitFor(() => expect(text(/Synced successfully/)).not.toBeNull());
    expect(api.calls.filter((c) => c.startsWith('POST')).length).toBe(0);
  });

  it('a failed Vercel deployment keeps the GitHub state visible', async () => {
    mockApi({ state: { status: 200, body: { github: GITHUB, vercel: vercel('ERROR') } } });
    render(panel(null, null));
    await waitFor(() => expect(text(/Vercel deployment failed/)).not.toBeNull());
    expect(text(/Synced successfully/)).not.toBeNull();
  });
});

describe('PublishPanel — Vercel states', () => {
  it('Preparing', () => {
    mockApi({ status: { status: 200, body: { status: 'QUEUED' } } });
    render(panel(GITHUB, vercel('QUEUED')));
    expect(text(/Preparing deployment/)).not.toBeNull();
  });

  it('Deploying', () => {
    mockApi({ status: { status: 200, body: { status: 'BUILDING' } } });
    render(panel(GITHUB, vercel('BUILDING')));
    expect(count(/Deployment in progress/)).toBeGreaterThan(0);
    expect((button('Deployment in progress…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Ready shows Open live site pointing at the stable URL, opening only when the user clicks', () => {
    const open = openSpy();
    mockApi();
    render(panel(GITHUB, vercel('READY')));
    expect(text(/Deployment ready/)).not.toBeNull();
    const link = screen.getByText('Open live site').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://blako.vercel.app');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(open).not.toHaveBeenCalled();
  });

  it('Failed offers Retry Vercel deployment', () => {
    mockApi();
    render(panel(GITHUB, vercel('ERROR')));
    expect(text(/Vercel deployment failed/)).not.toBeNull();
    expect(button('Retry Vercel deployment')).not.toBeNull();
  });

  it('Canceled offers Retry Vercel deployment', () => {
    mockApi();
    render(panel(GITHUB, vercel('CANCELED')));
    expect(text(/Deployment canceled/)).not.toBeNull();
    expect(button('Retry Vercel deployment')).not.toBeNull();
  });

  it('Timed out (after ~5 minutes of polling) is retryable', async () => {
    vi.useFakeTimers();
    mockApi({
      state: { status: 200, body: { github: GITHUB, vercel: vercel('BUILDING') } },
      status: { status: 200, body: { status: 'BUILDING' } },
    });
    render(panel(GITHUB, vercel('BUILDING')));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 105);
    });

    expect(text(/Timed out waiting for Vercel/)).not.toBeNull();
    expect(button('Check status again')).not.toBeNull();
    expect(button('Retry Vercel deployment')).not.toBeNull();
  });

  it('Retry Vercel deployment calls only the Vercel route — it never re-syncs GitHub', async () => {
    const api = mockApi({
      deploy: { status: 200, body: { deploymentId: 'dpl_2', projectId: 'prj_1', projectName: 'blako', url: 'https://x.vercel.app', status: 'QUEUED', productionUrl: null, aliasPending: false } },
      status: { status: 200, body: { status: 'QUEUED' } },
    });
    render(panel(GITHUB, vercel('ERROR')));

    fireEvent.click(button('Retry Vercel deployment')!);

    await waitFor(() => expect(text(/Preparing deployment/)).not.toBeNull());
    expect(api.count('POST /api/deploy/vercel')).toBe(1);
    expect(api.count('/api/deploy/github')).toBe(0);
  });

  it('a double click starts only one deployment', async () => {
    let release: (r: Reply) => void = () => {};
    const gate = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const api = mockApi({ deploy: () => gate, status: { status: 200, body: { status: 'QUEUED' } } });
    render(panel(GITHUB, null));

    const deploy = button('Deploy to Vercel')!;
    fireEvent.click(deploy);
    fireEvent.click(deploy);

    await act(async () => {
      release({ status: 200, body: { deploymentId: 'dpl_1', projectId: 'prj_1', projectName: 'blako', url: null, status: 'QUEUED', productionUrl: null, aliasPending: false } });
    });
    expect(api.count('POST /api/deploy/vercel')).toBe(1);
  });

  it('a Vercel failure on deploy is shown inside ForgeStudio, with GitHub state preserved', async () => {
    mockApi({ deploy: { status: 502, body: { error: 'Deployment failed (status 500)' } } });
    render(panel(GITHUB, null));
    fireEvent.click(button('Deploy to Vercel')!);

    await waitFor(() => expect(text(/Deployment failed \(status 500\)/)).not.toBeNull());
    expect(button('Retry Vercel deployment')).not.toBeNull();
    expect(text(/Synced successfully/)).not.toBeNull();
  });
});

'use client';
import { useEffect, useRef, useState } from 'react';

export type GithubInfo = {
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
  lastCommitSha?: string;
  syncedAt?: string;
};

export type VercelInfo = {
  projectId: string;
  projectName: string;
  deploymentId: string | null;
  url: string | null;
  productionUrl: string | null;
  status: string;
  deployedAt?: string;
};

type DeployUi = 'idle' | 'preparing' | 'deploying' | 'ready' | 'failed' | 'canceled' | 'timeout';

type Props = {
  projectId: string | null;
  initialGithub: GithubInfo | null;
  initialVercel: VercelInfo | null;
};

const POLL_MS = 3000;
const MAX_POLLS = 100; // 100 x 3s = 5 minutes
const MAX_ALIAS_WAIT_POLLS = 10; // after READY, wait up to ~30s for the production domain to be assigned
const IN_PROGRESS = ['QUEUED', 'INITIALIZING', 'BUILDING'];

function uiFromState(state: string): DeployUi {
  switch (state) {
    case 'READY':
      return 'ready';
    case 'ERROR':
      return 'failed';
    case 'CANCELED':
      return 'canceled';
    case 'BUILDING':
      return 'deploying';
    default:
      return 'preparing';
  }
}

function initialUi(v: VercelInfo | null): DeployUi {
  if (!v || !v.deploymentId) return 'idle';
  if (IN_PROGRESS.includes(v.status) || v.status === 'READY' || v.status === 'ERROR' || v.status === 'CANCELED') {
    return uiFromState(v.status);
  }
  return 'idle';
}

const UI_LABEL: Record<DeployUi, string> = {
  idle: 'Not deployed yet',
  preparing: 'Preparing',
  deploying: 'Deploying',
  ready: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
  timeout: 'Timed out',
};

export default function PublishPanel({ projectId, initialGithub, initialVercel }: Props) {
  const [repoName, setRepoName] = useState('');
  const [githubStatus, setGithubStatus] = useState<'idle' | 'pushing' | 'done' | 'error'>('idle');
  const [githubInfo, setGithubInfo] = useState<GithubInfo | null>(initialGithub);
  const [githubError, setGithubError] = useState('');
  const [githubNote, setGithubNote] = useState('');
  const [githubWarning, setGithubWarning] = useState('');

  const [vercelInfo, setVercelInfo] = useState<VercelInfo | null>(initialVercel);
  const [deployUi, setDeployUi] = useState<DeployUi>(() => initialUi(initialVercel));
  const [deployError, setDeployError] = useState(() =>
    initialVercel?.status === 'ERROR' ? 'The last deployment failed on Vercel.' : ''
  );
  const [deployWarning, setDeployWarning] = useState('');
  const [liveNote, setLiveNote] = useState('');
  const [elapsed, setElapsed] = useState(0);

  const alive = useRef(true);
  const pollToken = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (deployUi !== 'preparing' && deployUi !== 'deploying') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [deployUi]);

  function applyStatus(data: any) {
    const state: string = data?.status || 'QUEUED';
    setVercelInfo((prev) =>
      prev
        ? {
            ...prev,
            status: state,
            deploymentId: data?.deploymentId ?? prev.deploymentId,
            url: data?.url ?? prev.url,
            productionUrl: data?.productionUrl && !data?.aliasPending ? data.productionUrl : prev.productionUrl,
          }
        : prev
    );
    const ui = uiFromState(state);
    setDeployUi(ui);
    if (ui === 'failed') {
      setDeployError(data?.errorMessage || 'Vercel reported the build failed — open the deployment on Vercel for build logs.');
    }
    if (ui === 'ready' && data?.liveCheck) {
      setLiveNote(
        data.liveCheck.ok
          ? 'Verified: the live URL responds.'
          : data.liveCheck.status
          ? `Deployed, but the live URL answered HTTP ${data.liveCheck.status}. It may be access-protected on Vercel.`
          : 'Deployed, but the live URL could not be reached yet. Try opening it in a minute.'
      );
    }
  }

  async function pollDeployment() {
    if (!projectId) return;
    const token = ++pollToken.current;
    let sawReady = false;
    let aliasWaits = 0;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!alive.current || token !== pollToken.current) return;
      try {
        const res = await fetch(`/api/deploy/vercel/status?projectId=${encodeURIComponent(projectId)}`);
        const data = await res.json().catch(() => ({}));
        if (!alive.current || token !== pollToken.current) return;

        if (res.status === 401 || res.status === 404) {
          setDeployUi('failed');
          setDeployError(data?.error || 'Could not check the deployment status.');
          return;
        }
        if (!res.ok) continue; // transient server error — keep polling

        const state: string = data?.status || 'QUEUED';
        applyStatus(data);

        if (state === 'ERROR' || state === 'CANCELED') return;
        if (state === 'READY') {
          sawReady = true;
          if (!data?.aliasPending) return;
          aliasWaits++;
          if (aliasWaits >= MAX_ALIAS_WAIT_POLLS) return; // still showing READY with the deployment URL as fallback
        }
      } catch {
        // transient network error — keep polling
      }
    }

    if (alive.current && token === pollToken.current && !sawReady) {
      setDeployUi('timeout');
    }
  }

  // Rebuilds the publish state from the database (the source of truth). Used when the panel mounts or
  // remounts (reopened project, reload, parent re-render) so the workflow resumes at the right step.
  async function loadPublishState(restoreDeploy: boolean) {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/publish-state?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!alive.current || !data) return;

      if (data.github) setGithubInfo(data.github as GithubInfo);

      if (restoreDeploy && data.vercel) {
        const v = data.vercel as VercelInfo;
        setVercelInfo(v);
        const ui = initialUi(v);
        setDeployUi(ui);
        if (ui === 'failed') setDeployError('The last deployment failed on Vercel.');
        if (v.deploymentId && IN_PROGRESS.includes(v.status)) void pollDeployment();
      }
    } catch {
      // keep whatever state we already have
    }
  }

  useEffect(() => {
    void loadPublishState(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function syncToGithub() {
    if (!projectId) return;
    if (!githubInfo && !repoName.trim()) return;
    setGithubStatus('pushing');
    setGithubError('');
    setGithubNote('');
    setGithubWarning('');
    try {
      const res = await fetch('/api/deploy/github', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          repoName: githubInfo ? undefined : repoName.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setGithubStatus('error');
        setGithubError(data?.error || `Sync failed (status ${res.status})`);
        return;
      }

      setGithubInfo({
        owner: data.owner,
        repo: data.repo,
        url: data.url,
        defaultBranch: data.defaultBranch,
        lastCommitSha: data.lastCommitSha,
        syncedAt: new Date().toISOString(),
      });
      setGithubNote(
        data.adopted
          ? 'Reused your existing repository — no new repository was created.'
          : data.changed === false
          ? 'Already up to date — no new commit was needed.'
          : 'New commit pushed.'
      );
      if (data.warning) setGithubWarning(data.warning);
      setGithubStatus('done');
      void loadPublishState(false); // confirm what the database now holds
    } catch (e: any) {
      console.error(e);
      setGithubStatus('error');
      setGithubError(e?.message || 'Push failed');
    }
  }

  async function deployToVercel() {
    if (!projectId || !githubInfo) return;
    pollToken.current++; // stop any poll still running from an earlier deployment
    setDeployUi('preparing');
    setDeployError('');
    setDeployWarning('');
    setLiveNote('');
    setElapsed(0);
    try {
      const res = await fetch('/api/deploy/vercel', {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setDeployUi('failed');
        setDeployError(data?.error || `Deployment failed (status ${res.status})`);
        return;
      }

      setVercelInfo({
        projectId: data.projectId,
        projectName: data.projectName,
        deploymentId: data.deploymentId,
        url: data.url,
        productionUrl: vercelInfo?.productionUrl || null,
        status: data.status,
        deployedAt: new Date().toISOString(),
      });
      if (data.warning) setDeployWarning(data.warning);
      applyStatus(data);

      const state: string = data.status || 'QUEUED';
      if (state !== 'ERROR' && state !== 'CANCELED') {
        void pollDeployment();
      }
    } catch (e: any) {
      console.error(e);
      setDeployUi('failed');
      setDeployError(e?.message || 'Deployment failed');
    }
  }

  const deploying = deployUi === 'preparing' || deployUi === 'deploying';
  const readyUrl = vercelInfo?.productionUrl || vercelInfo?.url || null;
  const needsRetry = deployUi === 'failed' || deployUi === 'canceled' || deployUi === 'timeout';
  const hasDeployment = !!vercelInfo?.deploymentId;
  const deployButtonLabel = deploying
    ? 'Deployment in progress…'
    : needsRetry
    ? 'Retry Vercel deployment'
    : hasDeployment
    ? 'Redeploy to Vercel'
    : 'Deploy to Vercel';
  const notConnectedHint = (msg: string) => (/not connected/i.test(msg) ? ' Connect it from your integrations settings, then try again.' : '');

  return (
    <>
      <div className="flex flex-col items-center gap-2 mt-3 max-w-2xl mx-auto w-full">
        {githubInfo ? (
          <div className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/70 space-y-1">
            <p className="text-white/40 uppercase tracking-widest text-[10px]">GitHub</p>
            <p className="text-cyan-300/90">✓ Synced successfully</p>
            <p>
              <span className="text-white/40">Repository:</span> {githubInfo.owner}/{githubInfo.repo}
            </p>
            <p>
              <span className="text-white/40">Branch:</span> {githubInfo.defaultBranch}
            </p>
            {githubInfo.lastCommitSha && (
              <p>
                <span className="text-white/40">Commit:</span> {githubInfo.lastCommitSha.slice(0, 7)}
              </p>
            )}
            {githubInfo.syncedAt && (
              <p className="text-white/40">Synced {new Date(githubInfo.syncedAt).toLocaleString()}</p>
            )}
            {githubStatus === 'done' && githubNote && <p className="text-cyan-300/80">{githubNote}</p>}
            {githubWarning && <p className="text-orange-300">{githubWarning}</p>}
            <p>
              <a href={githubInfo.url} target="_blank" rel="noreferrer" className="text-white/50 hover:text-cyan-300 underline underline-offset-2">
                View GitHub repository
              </a>
            </p>
            <button
              onClick={syncToGithub}
              disabled={githubStatus === 'pushing' || !projectId}
              className="mt-1 text-xs text-white/50 hover:text-cyan-300 underline underline-offset-2 transition-colors disabled:opacity-40"
            >
              {githubStatus === 'pushing' ? 'Syncing…' : githubStatus === 'error' ? 'Retry GitHub sync' : 'Sync latest changes to GitHub'}
            </button>
          </div>
        ) : (
          <>
            <input
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="repo-name"
              className="text-xs bg-black/30 border border-white/10 rounded px-3 py-1.5 text-white/80 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/40 w-full max-w-xs"
            />
            <button
              onClick={syncToGithub}
              disabled={!repoName.trim() || githubStatus === 'pushing' || !projectId}
              className="text-xs text-white/50 hover:text-cyan-300 underline underline-offset-2 transition-colors disabled:opacity-40"
            >
              {githubStatus === 'pushing'
                ? 'Pushing to GitHub…'
                : !projectId
                ? 'Saving project…'
                : githubStatus === 'error'
                ? 'Retry GitHub sync'
                : 'Push to GitHub'}
            </button>
          </>
        )}
        {githubStatus === 'error' && githubError && (
          <p className="text-xs text-red-400 text-center">
            {githubError}
            {notConnectedHint(githubError)}
          </p>
        )}
      </div>

      {githubInfo && (
        <div className="flex flex-col items-center gap-2 max-w-2xl mx-auto w-full">
          <div className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/70 space-y-1">
            <p className="text-white/40 uppercase tracking-widest text-[10px]">Vercel</p>
            <p className="text-white/50">
              GitHub <span className="text-cyan-300/90">✓ Synced</span> → Vercel: {UI_LABEL[deployUi]}
            </p>
            {vercelInfo && (
              <p>
                <span className="text-white/40">Project:</span> {vercelInfo.projectName}
              </p>
            )}

            {deployUi === 'preparing' && (
              <p className="text-white/60 animate-pulse">Preparing deployment… ({elapsed}s)</p>
            )}
            {deployUi === 'deploying' && (
              <p className="text-white/60 animate-pulse">Deployment in progress… ({elapsed}s)</p>
            )}
            {deployUi === 'ready' && (
              <>
                <p className="text-cyan-300/90">✓ Deployment ready</p>
                {readyUrl && (
                  <p>
                    <a href={readyUrl} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
                      Open live site
                    </a>{' '}
                    <span className="text-white/40">{readyUrl.replace('https://', '')}</span>
                  </p>
                )}
                {liveNote && <p className="text-white/40">{liveNote}</p>}
              </>
            )}
            {deployUi === 'failed' && (
              <p className="text-red-400">
                Vercel deployment failed{deployError ? `: ${deployError}` : ''}
                {notConnectedHint(deployError)}
              </p>
            )}
            {deployUi === 'canceled' && <p className="text-orange-300">Deployment canceled.</p>}
            {deployUi === 'timeout' && (
              <p className="text-orange-300">
                Timed out waiting for Vercel — the deployment may still finish.{' '}
                <button onClick={() => void pollDeployment()} className="underline underline-offset-2">
                  Check status again
                </button>
              </p>
            )}
            {deployWarning && <p className="text-orange-300">{deployWarning}</p>}

            {deployUi !== 'ready' && vercelInfo?.productionUrl && (
              <p className="text-white/40">
                Previous live site:{' '}
                <a href={vercelInfo.productionUrl} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
                  {vercelInfo.productionUrl.replace('https://', '')}
                </a>
              </p>
            )}
            {vercelInfo?.deployedAt && hasDeployment && (
              <p className="text-white/40">Last deployed {new Date(vercelInfo.deployedAt).toLocaleString()}</p>
            )}

            <button
              onClick={deployToVercel}
              disabled={deploying}
              className="mt-2 rounded-lg px-4 py-2 text-sm font-semibold text-black transition-all disabled:opacity-50"
              style={{ background: 'linear-gradient(90deg, #00e5ff, #ff6b35)' }}
            >
              {deployButtonLabel}
            </button>
            <p className="text-white/30">Deploys the latest commit synced to GitHub. No new GitHub push needed.</p>
          </div>
        </div>
      )}
    </>
  );
}

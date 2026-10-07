// Stateful fake of the parts of the Vercel REST API that ForgeStudio uses, plus the live-URL check.
// No network, no PAT. Deployments walk through a scripted list of states, one per status request.
import { tick } from './fake-db';
import { json } from './fake-github';

export type FakeVercelOptions = {
  /** readyState returned by successive GET /v13/deployments/:id calls (the last one repeats). */
  states: string[];
  /** When true, READY deployments have no production alias yet. */
  noAlias: boolean;
  /** HTTP status returned when the live production URL is fetched. */
  liveStatus: number;
  errorMessage: string;
  /** When true, POST /v13/deployments fails with a 500. */
  createDeploymentFails: boolean;
};

type VProject = { id: string; name: string; link: { type: string; org: string; repo: string; repoId?: number } };
type VDeployment = { id: string; name: string; url: string; states: string[]; idx: number; sha?: string };

export function createFakeVercel(initial: Partial<FakeVercelOptions> = {}) {
  const opts: FakeVercelOptions = {
    states: ['QUEUED', 'BUILDING', 'READY'],
    noAlias: false,
    liveStatus: 200,
    errorMessage: 'Build failed: Module not found',
    createDeploymentFails: false,
    ...initial,
  };
  const projects = new Map<string, VProject>();
  const deployments = new Map<string, VDeployment>();
  const log: { seq: number; method: string; host: string; path: string; body?: any }[] = [];
  let projectSeq = 0;
  let deploymentSeq = 0;

  const byName = (name: string) => [...projects.values()].find((p) => p.name === name);

  function seedProject(name: string, link: { org: string; repo: string; repoId?: number }) {
    const p: VProject = { id: `prj_${++projectSeq}`, name, link: { type: 'github', ...link } };
    projects.set(p.id, p);
    return p;
  }
  function seedDeployment(id: string, name: string, states: string[]) {
    const d: VDeployment = { id, name, url: `${name}-${id}.vercel.app`, states, idx: 0 };
    deployments.set(id, d);
    return d;
  }

  const handler = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    const method = String(init?.method || 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    log.push({ seq: tick(), method, host: url.host, path, body });

    // anything that is not the Vercel API is the live site being checked
    if (url.host !== 'api.vercel.com') return new Response('<html>site</html>', { status: opts.liveStatus });

    if (method === 'POST' && path === '/v11/projects') {
      if (byName(body.name)) return json(409, { error: { code: 'conflict', message: 'The project name already exists' } });
      const [org, repo] = String(body.gitRepository?.repo).split('/');
      const p = seedProject(body.name, { org, repo });
      return json(200, { id: p.id, name: p.name });
    }
    let m = path.match(/^\/v(?:9|10)\/projects\/(.+)$/);
    if (method === 'GET' && m) {
      const p = projects.get(m[1]) ?? byName(m[1]);
      return p ? json(200, { id: p.id, name: p.name, link: p.link }) : json(404, { error: { message: 'Not found' } });
    }
    if (method === 'POST' && path === '/v13/deployments') {
      if (opts.createDeploymentFails) return json(500, { error: { message: 'boom' } });
      const d = seedDeployment(`dpl_${++deploymentSeq}`, body.name, opts.states);
      d.sha = body.gitSource?.sha;
      return json(200, { id: d.id, url: d.url, readyState: 'QUEUED', meta: { githubCommitSha: d.sha } });
    }
    m = path.match(/^\/v13\/deployments\/(.+)$/);
    if (method === 'GET' && m) {
      const d = deployments.get(m[1]);
      if (!d) return json(404, { error: { message: 'Not found' } });
      const state = d.states[Math.min(d.idx, d.states.length - 1)];
      d.idx++;
      return json(200, {
        id: d.id,
        url: d.url,
        readyState: state,
        alias: state === 'READY' && !opts.noAlias ? [`${d.name}-git-main.vercel.app`, `${d.name}.vercel.app`] : [],
        errorMessage: state === 'ERROR' ? opts.errorMessage : undefined,
        meta: { githubCommitSha: d.sha },
      });
    }
    return json(404, { error: { message: `fake-vercel: unhandled ${method} ${path}` } });
  };

  return {
    handler,
    opts,
    projects,
    deployments,
    log,
    seedProject,
    seedDeployment,
    calls: (method: string, pathEnd: string) => log.filter((l) => l.method === method && l.path.endsWith(pathEnd)),
  };
}

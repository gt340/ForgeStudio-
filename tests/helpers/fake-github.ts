// Stateful fake of the parts of the GitHub REST API that /api/deploy/github uses. No network, no token.
import { createHash } from 'node:crypto';
import { tick } from './fake-db';

type Commit = { sha: string; message: string; tree: string };
type Repo = { id: number; name: string; created_at: string; commits: Commit[]; head: string };

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createFakeGithub(opts: { login?: string; failOn?: (method: string, path: string) => Response | null } = {}) {
  const login = opts.login ?? 'gt340';
  const repos = new Map<string, Repo>();
  const trees = new Map<string, Record<string, string>>();
  const pending = new Map<string, Commit>();
  const log: { seq: number; method: string; path: string; body?: any }[] = [];
  let repoSeq = 1000;
  let commitSeq = 0;

  const storeTree = (files: Record<string, string>) => {
    const sha = createHash('sha1')
      .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    trees.set(sha, files);
    return sha;
  };
  const newCommit = (message: string, tree: string): Commit => ({
    sha: createHash('sha1').update(`${++commitSeq}:${message}:${tree}`).digest('hex'),
    message,
    tree,
  });

  function seedRepo(name: string, o: { message?: string; createdAt?: string; files?: Record<string, string> } = {}) {
    const commit = newCommit(o.message ?? 'Initial commit', storeTree(o.files ?? { 'README.md': `# ${name}` }));
    const repo: Repo = {
      id: ++repoSeq,
      name,
      created_at: o.createdAt ?? new Date().toISOString(),
      commits: [commit],
      head: commit.sha,
    };
    repos.set(name.toLowerCase(), repo);
    return repo;
  }

  const repoJson = (r: Repo) => ({
    id: r.id,
    name: r.name,
    full_name: `${login}/${r.name}`,
    html_url: `https://github.com/${login}/${r.name}`,
    default_branch: 'main',
    created_at: r.created_at,
    owner: { login },
  });

  const handler = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    const method = String(init?.method || 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    log.push({ seq: tick(), method, path, body });

    if (url.host !== 'api.github.com') throw new Error(`fake-github: unexpected host ${url.host}`);
    const forced = opts.failOn?.(method, path);
    if (forced) return forced;

    if (method === 'GET' && path === '/user') return json(200, { login });
    if (method === 'POST' && path === '/user/repos') {
      if (repos.has(String(body.name).toLowerCase())) return json(422, { message: 'Repository creation failed.' });
      return json(201, repoJson(seedRepo(body.name)));
    }

    const m = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return json(404, { message: 'Not Found' });
    const repo = repos.get(m[2].toLowerCase());
    if (!repo) return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';

    if (method === 'GET' && rest === '') return json(200, repoJson(repo));
    if (method === 'GET' && rest.startsWith('/commits/')) {
      const head = repo.commits.find((c) => c.sha === repo.head)!;
      return json(200, { sha: head.sha, commit: { message: head.message } });
    }
    if (method === 'GET' && rest.startsWith('/git/ref/heads/')) return json(200, { object: { sha: repo.head } });
    if (method === 'GET' && rest.startsWith('/git/commits/')) {
      const sha = rest.split('/').pop()!;
      const c = repo.commits.find((x) => x.sha === sha);
      return c ? json(200, { sha, tree: { sha: c.tree } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const files: Record<string, string> = { ...(trees.get(body.base_tree) ?? {}) };
      for (const e of body.tree) files[e.path] = e.content;
      return json(201, { sha: storeTree(files) });
    }
    if (method === 'POST' && rest === '/git/commits') {
      const c = newCommit(body.message, body.tree);
      pending.set(c.sha, c);
      return json(201, { sha: c.sha });
    }
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/')) {
      const c = pending.get(body.sha);
      if (!c) return json(422, { message: 'Object does not exist' });
      repo.commits.push(c);
      repo.head = c.sha;
      return json(200, { object: { sha: c.sha } });
    }
    return json(404, { message: `fake-github: unhandled ${method} ${path}` });
  };

  return {
    handler,
    repos,
    log,
    seedRepo,
    messages: (name: string) => repos.get(name.toLowerCase())?.commits.map((c) => c.message) ?? [],
    headFiles: (name: string) => {
      const r = repos.get(name.toLowerCase());
      const head = r?.commits.find((c) => c.sha === r.head);
      return head ? trees.get(head.tree) ?? {} : {};
    },
    calls: (method: string, pathEnd: string) => log.filter((l) => l.method === method && l.path.endsWith(pathEnd)),
  };
}
